/**
 * `brandCss` is the one place an app's design tokens become CSS, and it is
 * served as a virtual module, so a wrong custom-property name is invisible at
 * build time and shows up as an unstyled component.
 *
 * The plugin half is driven directly rather than through a Vite dev server: it
 * only reads `config.root` and `server.watcher`, so a real server would add
 * startup cost and hide nothing.
 */
import { afterEach, describe, expect, it } from "@effect/vitest"
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { AppManifest, Brand } from "../src/app.ts"
import { RouterError } from "../src/router.ts"
import { brandCss, brandModuleId, createApp, loadManifest, manifestModuleId } from "../src/vite.ts"
import { appTrees } from "./support/appTree.ts"
import { layers } from "./support/layers.ts"

const { write: tree, remove: removeTrees } = appTrees("smthrs-vite-")
const unwritable: Array<string> = []

afterEach(() => {
  while (unwritable.length > 0) chmodSync(unwritable.pop()!, 0o600)
  removeTrees()
})

const minimal: Brand = { name: "test", tokens: { accent: "#5288c2", background: "#ffffff" } }

const manifestOf = (brand: Brand): AppManifest => ({
  name: "test",
  brand,
  nav: [],
  dirs: { app: "app", flows: "flows", tools: "tools" },
  deploy: { cloudflare: { workerName: "w", domain: "d.example.com", config: "worker/wrangler.jsonc" } }
})

describe("brandCss", () => {
  it("maps tokens onto house custom properties", () => {
    const css = brandCss(minimal)
    expect(css).toContain("--house-accent: #5288c2;")
    expect(css).toContain("--house-background: #ffffff;")
  })

  it("maps tokens onto the styleguide properties the components read", () => {
    const css = brandCss(minimal)
    expect(css).toContain("--brand: #5288c2;")
    expect(css).toContain("--bg: #ffffff;")
  })

  it("scopes declarations to :root and a themed subtree", () => {
    const css = brandCss(minimal)
    expect(css).toContain(":root:root:root:root, :root:root:root [data-theme] {")
    expect(css.trimEnd().endsWith("}")).toBe(true)
  })

  it("emits nothing for tokens the brand did not set", () => {
    const css = brandCss(minimal)
    expect(css).not.toContain("--house-secondary")
    expect(css).not.toContain("--house-danger")
  })

  it("emits a token with no styleguide alias under its house name only", () => {
    const css = brandCss({ name: "t", tokens: { radiusComposer: "1.875rem" } })
    expect(css).toContain("--house-radius-composer: 1.875rem;")
    expect(css.split("\n").filter((line) => line.trim().startsWith("--"))).toHaveLength(1)
  })

  it("declares font stacks under the house font properties", () => {
    const css = brandCss({
      ...minimal,
      fonts: { body: "Geist, sans-serif", mono: "Geist Mono", display: "PT Serif", wordmark: "Source Serif 4" }
    })
    expect(css).toContain("--house-font-ui: Geist, sans-serif;")
    expect(css).toContain("--font-sans: Geist, sans-serif;")
    expect(css).toContain("--house-font-mono: Geist Mono;")
    expect(css).toContain("--font-mono: Geist Mono;")
    expect(css).toContain("--house-font-display: PT Serif;")
    expect(css).toContain("--house-font-wordmark: Source Serif 4;")
  })

  it("puts every Google Fonts @import ahead of the first rule", () => {
    const css = brandCss({ ...minimal, fonts: { googleFonts: ["Geist:wght@400", "PT+Serif:wght@700"] } })
    const lines = css.split("\n")
    expect(lines[0]).toBe("@import url(\"https://fonts.googleapis.com/css2?family=Geist:wght@400&display=swap\");")
    expect(lines[1]).toBe("@import url(\"https://fonts.googleapis.com/css2?family=PT+Serif:wght@700&display=swap\");")
    expect(lines.indexOf(":root:root:root:root, :root:root:root [data-theme] {")).toBe(2)
  })

  it("refuses a value that could close the declaration or the rule", () => {
    const escapes = ["red; } body { display: none", "red\n}", "a{b", "red /* x", "\\7d", "</style>"]
    for (const value of escapes) {
      expect(() => brandCss({ name: "t", tokens: { accent: value } })).toThrow("brand token accent")
      expect(() => brandCss({ ...minimal, fonts: { mono: value } })).toThrow("brand font mono")
    }
    const stack = "\"Geist Mono\", 'PT Serif', ui-monospace"
    expect(brandCss({ ...minimal, fonts: { mono: stack } })).toContain(`--font-mono: ${stack};`)
  })

  it("refuses a Google Fonts entry outside the family= grammar", () => {
    for (const family of ["Geist\");@import url(\"https://evil.example/x.css", "Geist&text=x", "Geist\n"]) {
      expect(() => brandCss({ ...minimal, fonts: { googleFonts: [family] } })).toThrow("is not a Google Fonts")
    }
    const css = brandCss({ ...minimal, fonts: { googleFonts: ["PT+Serif:ital,wght@0,400;1,100..900"] } })
    expect(css).toContain("family=PT+Serif:ital,wght@0,400;1,100..900&display=swap")
  })

  it("emits no @import when the brand names no Google fonts", () => {
    expect(brandCss(minimal)).not.toContain("@import")
  })

  it("emits a valid empty rule for a brand with no tokens", () => {
    expect(brandCss({ name: "bare", tokens: {} })).toBe(
      ":root:root:root:root, :root:root:root [data-theme] {\n}\n"
    )
  })
})

describe("loadManifest", () => {
  it("reads App.manifest out of PACKAGE.ts", async () => {
    const root = tree({
      "PACKAGE.ts": `export const App = { manifest: ${JSON.stringify(manifestOf(minimal))} }\n`
    })
    expect(await loadManifest(root)).toEqual(manifestOf(minimal))
  })

  it("refuses a PACKAGE.ts that exports no App", async () => {
    const root = tree({ "PACKAGE.ts": "export const Package = {}\n" })
    await expect(loadManifest(root)).rejects.toThrow("must export `App`")
  })
})

describe("createApp", () => {
  it("regenerates both route tables when the config resolves", async () => {
    const root = tree({ ...layers, "app/page.tsx": "export default () => null\n" })
    const plugin = createApp({ manifest: async () => manifestOf(minimal) })
    await plugin.configResolved({ root })
    expect(readFileSync(join(root, "routes.ui.gen.ts"), "utf8")).toContain("app/page.tsx")
    expect(existsSync(join(root, "routes.gen.ts"))).toBe(true)
  })

  it("prefers an explicit root over Vite's", async () => {
    const root = tree({ ...layers, "app/page.tsx": "export default () => null\n" })
    const elsewhere = tree(layers)
    const plugin = createApp({ root, manifest: async () => manifestOf(minimal) })
    await plugin.configResolved({ root: elsewhere })
    expect(existsSync(join(root, "routes.gen.ts"))).toBe(true)
    expect(existsSync(join(elsewhere, "routes.gen.ts"))).toBe(false)
  })

  it("loads the manifest from PACKAGE.ts when none is supplied", async () => {
    const root = tree({
      ...layers,
      "site/page.tsx": "export default () => null\n",
      "PACKAGE.ts": `export const App = { manifest: ${
        JSON.stringify({ ...manifestOf(minimal), dirs: { app: "site", flows: "flows", tools: "tools" } })
      } }\n`
    })
    const plugin = createApp()
    await plugin.configResolved({ root })
    // The manifest's own dirs decide what is routed, not the defaults.
    expect(readFileSync(join(root, "routes.ui.gen.ts"), "utf8")).toContain("site/page.tsx")
  })

  it.each(["/", "\\"])("regenerates for %s-separated routed paths and ignores anything else", async (separator) => {
    const root = tree({ ...layers, "app/page.tsx": "export default () => null\n" })
    const plugin = createApp({ root, manifest: async () => manifestOf(minimal) })
    await plugin.configResolved({ root })

    const listeners: Array<(file: string) => void> = []
    plugin.configureServer({ watcher: { on: (_event, listener) => listeners.push(listener) } })
    expect(listeners).toHaveLength(2)

    mkdirSync(join(root, "app/panes"), { recursive: true })
    writeFileSync(join(root, "app/panes/balances.tsx"), "export const Pane = {}\n")

    const eventPath = (file: string): string => join(root, file).replaceAll("\\", "/").replaceAll("/", separator)
    listeners[0]!(eventPath("src/theme.css"))
    expect(readFileSync(join(root, "routes.ui.gen.ts"), "utf8")).not.toContain("balances")

    listeners[0]!(eventPath("app/panes/balances.tsx"))
    expect(readFileSync(join(root, "routes.ui.gen.ts"), "utf8")).toContain("balances")
  })

  // The listener runs inside chokidar's emit, so a throw out of it is an
  // uncaught exception that takes the dev server down rather than an error
  // overlay. A capitalised pane file, a second flow.ts for an existing id, or
  // a deleted root AGENT.ts each raise one while the server is running.
  it("reports a refused tree instead of taking the dev server down", async () => {
    const root = tree({ ...layers, "app/page.tsx": "export default () => null\n" })
    const refused: Array<RouterError> = []
    const plugin = createApp({
      root,
      manifest: async () => manifestOf(minimal),
      onRouterError: (error) => refused.push(error)
    })
    await plugin.configResolved({ root })
    const before = readFileSync(join(root, "routes.ui.gen.ts"), "utf8")

    const listeners: Array<(file: string) => void> = []
    plugin.configureServer({ watcher: { on: (_event, listener) => listeners.push(listener) } })

    mkdirSync(join(root, "app/panes"), { recursive: true })
    const pane = join(root, "app/panes/Balances.tsx")
    writeFileSync(pane, "export const Pane = {}\n")

    expect(() => listeners[0]!(pane)).not.toThrow()
    expect(refused).toHaveLength(1)
    expect(refused[0]!.code).toBe("invalid_name")
    expect(refused[0]!.message).toContain("app/panes/Balances.tsx")
    // The previous tables survive: a refusal leaves the app serving what it
    // was serving.
    expect(readFileSync(join(root, "routes.ui.gen.ts"), "utf8")).toBe(before)
  })

  it("names the refusal on stderr when the host installed no reporter", async () => {
    const root = tree({ ...layers, "app/page.tsx": "export default () => null\n" })
    const plugin = createApp({ root, manifest: async () => manifestOf(minimal) })
    await plugin.configResolved({ root })

    const listeners: Array<(file: string) => void> = []
    plugin.configureServer({ watcher: { on: (_event, listener) => listeners.push(listener) } })

    mkdirSync(join(root, "app/panes"), { recursive: true })
    const pane = join(root, "app/panes/Balances.tsx")
    writeFileSync(pane, "export const Pane = {}\n")

    const written: Array<string> = []
    const original = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      written.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    try {
      expect(() => listeners[0]!(pane)).not.toThrow()
    } finally {
      process.stderr.write = original
    }
    expect(written.join("")).toContain("smthrs-create-app: invalid_name:")
    expect(written.join("")).toContain("app/panes/Balances.tsx")
  })

  // A full disk, a locked file, a read-only checkout: the tree is fine and the
  // plugin is fine, the machine refused the write. That leaves the previous
  // tables on disk exactly as a refused tree does, so the dev server names it
  // and keeps serving them rather than dying inside chokidar's emit.
  it.skipIf(process.getuid?.() === 0)(
    "reports a filesystem refusal instead of taking the dev server down; root bypasses permission bits",
    async () => {
      const root = tree({ ...layers, "app/page.tsx": "export default () => null\n" })
      const plugin = createApp({ root, manifest: async () => manifestOf(minimal) })
      await plugin.configResolved({ root })
      const before = readFileSync(join(root, "routes.ui.gen.ts"), "utf8")

      const listeners: Array<(file: string) => void> = []
      plugin.configureServer({ watcher: { on: (_event, listener) => listeners.push(listener) } })

      mkdirSync(join(root, "app/panes"), { recursive: true })
      const pane = join(root, "app/panes/balances.tsx")
      writeFileSync(pane, "export const Pane = {}\n")
      rmSync(join(root, "routes.gen.ts"))
      // Windows honors a file's read-only bit, not a directory's mode bits.
      const staging = join(root, "routes.gen.ts.tmp")
      writeFileSync(staging, "reserved staging file")
      unwritable.push(staging)
      chmodSync(staging, 0o400)

      const written: Array<string> = []
      const original = process.stderr.write.bind(process.stderr)
      process.stderr.write = ((chunk: string | Uint8Array): boolean => {
        written.push(String(chunk))
        return true
      }) as typeof process.stderr.write
      try {
        expect(() => listeners[0]!(pane)).not.toThrow()
      } finally {
        process.stderr.write = original
      }
      expect(written.join("")).toMatch(/smthrs-create-app: (?:EACCES|EROFS|EPERM):/)
      expect(written.join("")).toContain("routes.gen.ts")
      // The tables the server is serving survive the refusal.
      expect(readFileSync(join(root, "routes.ui.gen.ts"), "utf8")).toBe(before)
    }
  )

  it("still propagates a failure that is not a refused tree", async () => {
    // Only a RouterError means "the tree is wrong". Anything else is a defect
    // in the plugin or the filesystem, and swallowing it would leave the dev
    // server silently serving a table it can no longer regenerate.
    const root = tree({ ...layers, "app/page.tsx": "export default () => null\n" })
    const plugin = createApp({ root, manifest: async () => manifestOf(minimal) })
    await plugin.configResolved({ root })

    const listeners: Array<(file: string) => void> = []
    plugin.configureServer({ watcher: { on: (_event, listener) => listeners.push(listener) } })

    const page = join(root, "app/page.tsx")
    rmSync(root, { recursive: true, force: true })
    let thrown: unknown
    try {
      listeners[0]!(page)
    } catch (cause) {
      thrown = cause
    }
    expect(thrown).toBeDefined()
    expect(thrown).not.toBeInstanceOf(RouterError)
    expect((thrown as NodeJS.ErrnoException).code).toBe("ENOENT")
  })

  it("propagates a regeneration defect without an errno code", async () => {
    const root = tree({ ...layers, "app/page.tsx": "export default () => null\n" })
    const manifest = manifestOf(minimal)
    const plugin = createApp({ root, manifest: async () => manifest })
    await plugin.configResolved({ root })
    const listeners: Array<(file: string) => void> = []
    plugin.configureServer({ watcher: { on: (_event, listener) => listeners.push(listener) } })
    const defect = new Error("manifest unavailable")
    Object.defineProperty(manifest, "dirs", {
      get: () => {
        throw defect
      }
    })
    expect(() => listeners[0]!(join(root, "app/page.tsx"))).toThrow(defect)
  })

  it("resolves only its own virtual modules", () => {
    const plugin = createApp()
    expect(plugin.resolveId(brandModuleId)).toBe(`\0${brandModuleId}`)
    expect(plugin.resolveId(manifestModuleId)).toBe(`\0${manifestModuleId}`)
    expect(plugin.resolveId("react")).toBeNull()
  })

  it("serves the brand and the manifest, and nothing else", async () => {
    const root = tree(layers)
    const plugin = createApp({ root, manifest: async () => manifestOf(minimal) })
    await plugin.configResolved({ root })
    expect(plugin.load(`\0${brandModuleId}`)).toContain("--house-accent: #5288c2;")
    expect(plugin.load(`\0${manifestModuleId}`)).toBe(`export default ${JSON.stringify(manifestOf(minimal))}`)
    expect(plugin.load("\0virtual:other")).toBeNull()
  })

  it("refuses to serve a virtual module before the config resolved", () => {
    const plugin = createApp()
    expect(() => plugin.load(`\0${brandModuleId}`)).toThrow("before configResolved ran")
  })
})
