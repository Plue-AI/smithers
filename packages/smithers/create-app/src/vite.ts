/**
 * The Vite plugin.
 *
 * It does two things. It regenerates `routes.gen.ts` and `routes.ui.gen.ts`
 * when the config resolves and whenever a routed file appears or disappears,
 * so the tables are never stale in dev. And it serves the brand declared in
 * `PACKAGE.ts` as two virtual modules: `virtual:smthrs-app/brand.css` for the
 * CSS custom properties, and `virtual:smthrs-app/manifest` for the shell.
 *
 * @since 0.1.0
 */

import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { Plugin } from "vite"
import type { AppManifest, Brand, BrandToken } from "./app.ts"
import { RouterError, writeRoutes } from "./router.ts"

/**
 * The virtual module holding the brand as CSS custom properties.
 *
 * @category models
 * @since 0.1.0
 */
export const brandModuleId = "virtual:smthrs-app/brand.css"

/**
 * The virtual module holding the app manifest as JSON.
 *
 * @category models
 * @since 0.1.0
 */
export const manifestModuleId = "virtual:smthrs-app/manifest"

/**
 * Where each brand token lands in the `@smthrs/ui` styleguide vocabulary.
 *
 * `@smthrs/ui` components resolve their colors through the styleguide's custom
 * properties (`--bg`, `--text`, `--brand`, `--r-2`), so those are the names
 * that decide whether a component is styled. The `--house-*` aliases are
 * emitted for every token as well, so app CSS can read the brand by the same
 * vocabulary the author declared it in.
 */
const styleguide: Partial<Record<BrandToken, ReadonlyArray<string>>> = {
  primary: ["--inverse-bg", "--code-bg"],
  primarySubtle: ["--hover", "--code-text"],
  accent: ["--brand"],
  accentForeground: ["--inverse-text"],
  success: ["--success"],
  warning: ["--warning"],
  danger: ["--danger"],
  info: ["--info"],
  background: ["--bg"],
  surface: ["--surface-2", "--hover-subtle"],
  surfaceRaised: ["--surface", "--surface-3"],
  border: ["--border"],
  borderStrong: ["--border-strong", "--border-solid"],
  foreground: ["--text"],
  foregroundMuted: ["--text-muted"],
  foregroundSubtle: ["--text-faint", "--text-placeholder"],
  radiusSm: ["--r-1"],
  radiusMd: ["--r-2"],
  radiusLg: ["--r-3", "--r-bubble"],
  radiusXl: ["--r-4"],
  radiusPill: ["--r-full"],
  shadowSm: ["--shadow-1"],
  shadowMd: ["--shadow-2"],
  shadowLg: ["--shadow-3"]
}

const houseName = (token: string): string =>
  `--house-${token.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`

/**
 * The selector the brand rule is emitted with.
 *
 * `:root` is repeated to raise specificity, which is the only lever the rule
 * has. `virtual:smthrs-app/brand.css` is a CSS import, so a bundler puts it in
 * `<head>`, while `@smthrs/ui`'s `<SmithersUiStyles withTheme/>` renders its
 * `<style>` inside the tree; the styleguide sheet is therefore always later in
 * document order. Its most specific token rule is
 * `:root[data-palette='<key>'][data-theme='dark']` at (0,3,0), so (0,4,0) here
 * carries the brand over every palette and mode. The second half is the same
 * rank for a themed subtree; the descendant combinator keeps it off `:root`
 * itself, which the first half already covers.
 */
const brandSelector = ":root:root:root:root, :root:root:root [data-theme]"

/**
 * What a declaration value may not contain: a character that ends the
 * declaration or the rule, a line break, or a comment opener. Quotes stay
 * legal, because a font stack needs them.
 */
const unsafeValue = /[;{}\r\n\\<]|\/\*/

/** A Google Fonts `family=` specification: `PT+Serif:ital,wght@0,400;1,700..900`. */
const googleFamily = /^[A-Za-z0-9+:@;,.-]+$/

const declared = (name: string, value: string): string => {
  if (unsafeValue.test(value)) {
    throw new Error(`brand ${name} must be one CSS value; ${JSON.stringify(value)} could end the rule`)
  }
  return value
}

/**
 * Renders a brand as one CSS rule of custom properties.
 *
 * A token the brand did not declare is not emitted, so the styleguide default
 * survives; this is the only place that mapping is written, so an app never
 * needs a second sheet to alias the same names. The rule is emitted with
 * {@link brandSelector}, which outranks the styleguide's own token rules.
 * Google Fonts `@import` rules come first, because CSS ignores an `@import`
 * that follows a rule.
 *
 * Every value is written verbatim, so one that could close the declaration or
 * the rule, or a font family outside the Google Fonts `family=` grammar,
 * throws rather than inject a rule or an `@import` into every page.
 *
 * @category constructors
 * @since 0.1.0
 */
export const brandCss = (brand: Brand): string => {
  const declarations: Array<string> = []
  for (const [token, raw] of Object.entries(brand.tokens)) {
    const value = declared(`token ${token}`, raw)
    declarations.push(`  ${houseName(token)}: ${value};`)
    for (const name of styleguide[token as BrandToken] ?? []) declarations.push(`  ${name}: ${value};`)
  }
  const fonts = brand.fonts ?? {}
  const font = (role: "body" | "mono" | "display" | "wordmark", names: ReadonlyArray<string>): void => {
    const value = fonts[role]
    if (value === undefined) return
    for (const name of names) declarations.push(`  ${name}: ${declared(`font ${role}`, value)};`)
  }
  font("body", ["--house-font-ui", "--font-sans"])
  font("mono", ["--house-font-mono", "--font-mono"])
  font("display", ["--house-font-display"])
  font("wordmark", ["--house-font-wordmark"])
  const imports = (fonts.googleFonts ?? []).map((family) => {
    if (!googleFamily.test(family)) {
      throw new Error(`brand googleFonts entry ${JSON.stringify(family)} is not a Google Fonts family= specification`)
    }
    return `@import url("https://fonts.googleapis.com/css2?family=${family}&display=swap");`
  })
  return [...imports, `${brandSelector} {`, ...declarations, "}", ""].join("\n")
}

/**
 * Loads an app's manifest by evaluating its `PACKAGE.ts` through `tsx`.
 *
 * The config process is not a TypeScript process, and `PACKAGE.ts` imports
 * `@smthrs/targets`, so the manifest cannot simply be imported. `tsx` is an
 * optional peer for exactly this reason: an app that passes
 * {@link CreateAppPluginOptions.manifest} never needs it.
 *
 * @category constructors
 * @since 0.1.0
 */
export const loadManifest = async (root: string): Promise<AppManifest> => {
  const { tsImport } = await import("tsx/esm/api")
  // `parentURL` is derived from the app root rather than from `import.meta.url`.
  // The published CommonJS build lowers `import.meta` to `{}`, so the module
  // URL is `undefined` there and `tsImport` refuses the call; resolving the
  // manifest relative to the app that owns it is also the more accurate
  // context, because that is where its imports live.
  const target = pathToFileURL(join(root, "PACKAGE.ts")).href
  const loaded = await tsImport(target, { parentURL: target, tsconfig: false }) as {
    readonly App?: { readonly manifest?: AppManifest }
  }
  const manifest = loaded.App?.manifest
  if (manifest === undefined) {
    throw new Error(`${root}/PACKAGE.ts must export \`App\` from CreateApp({ ... })`)
  }
  return manifest
}

/**
 * What the plugin takes. Both fields have working defaults; an app normally
 * writes `createApp()`.
 *
 * @category models
 * @since 0.1.0
 */
export interface CreateAppPluginOptions {
  /** App root. Defaults to Vite's resolved root. */
  readonly root?: string
  /** Manifest loader. Defaults to {@link loadManifest} over `<root>/PACKAGE.ts`. */
  readonly manifest?: () => Promise<AppManifest>
  /**
   * What to do with a `RouterError` raised while the dev server is running.
   *
   * Defaults to reporting it on stderr. `configResolved` is deliberately not
   * routed through it: Vite awaits that hook, so a refused tree at startup
   * must fail the startup.
   */
  readonly onRouterError?: (error: RouterError) => void
}

/** Reports a refused tree without taking the dev server down. */
const reportOnStderr = (error: RouterError): void => {
  process.stderr.write(`smthrs-create-app: ${error.code}: ${error.message}\n`)
}

/**
 * The errno codes a regeneration can fail with that say the machine refused
 * the write rather than that the tree or the plugin is wrong: a full disk or
 * quota, a locked or read-only file, an exhausted descriptor table.
 *
 * `ENOENT` is deliberately absent. It means the app root itself is gone, so
 * there is nothing left to serve and the throw stands.
 */
const refusedByFilesystem = new Set([
  "EACCES",
  "EAGAIN",
  "EBUSY",
  "EDQUOT",
  "EMFILE",
  "ENFILE",
  "ENOSPC",
  "EPERM",
  "EROFS"
])

const isFilesystemRefusal = (cause: unknown): cause is NodeJS.ErrnoException =>
  cause instanceof Error && refusedByFilesystem.has((cause as NodeJS.ErrnoException).code ?? "")

/**
 * Reports a filesystem refusal without taking the dev server down.
 *
 * This is not routed through {@link CreateAppPluginOptions.onRouterError}: the
 * tables are fine and the tree is fine, so the report is about the machine and
 * not about anything the app author can fix in their tree. Node's message
 * already names the syscall and the path.
 */
const reportRefusalOnStderr = (error: NodeJS.ErrnoException): void => {
  process.stderr.write(`smthrs-create-app: ${error.code}: could not write the route tables: ${error.message}\n`)
}

/** The slice of `ViteDevServer` the plugin watches. */
interface WatchedServer {
  readonly watcher: {
    readonly on: (event: "add" | "unlink", listener: (file: string) => void) => unknown
  }
}

/**
 * The plugin, typed by what it actually uses rather than by Vite's full hook
 * signatures, so a host — or a test — can drive it directly.
 *
 * @category models
 * @since 0.1.0
 */
export interface CreateAppPlugin {
  readonly name: string
  readonly configResolved: (config: { readonly root: string }) => Promise<void>
  readonly configureServer: (server: WatchedServer) => void
  readonly resolveId: (id: string) => string | null
  readonly load: (id: string) => string | null
}

/** Whether a changed path is one the route tables are derived from. */
const isRouted = (file: string): boolean => {
  const path = file.replaceAll("\\", "/")
  return /\/(?:page|layout)\.tsx$/.test(path) || /\/panes\/[^/]+\.tsx$/.test(path) ||
    /\/flow\.ts$/.test(path) || /\/(?:AGENT|SANDBOX|TOOLS)\.ts$/.test(path)
}

/**
 * Creates the plugin.
 *
 * @example
 * ```ts
 * import { createApp } from "@smthrs/create-app/vite"
 * import react from "@vitejs/plugin-react"
 * import { defineConfig } from "vite"
 *
 * export default defineConfig({ plugins: [createApp(), react()] })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const createApp = (options: CreateAppPluginOptions = {}): CreateAppPlugin => {
  let root = options.root ?? process.cwd()
  let manifest: AppManifest | undefined
  const required = (): AppManifest => {
    if (manifest === undefined) throw new Error("smthrs-create-app: the manifest is read before configResolved ran")
    return manifest
  }
  // Only reached after `configResolved` settled the manifest, so the dirs are
  // the manifest's rather than the defaults.
  const regenerate = (): void => {
    writeRoutes({ root, dirs: required().dirs })
  }
  const plugin = {
    name: "smthrs-create-app",
    async configResolved(config: { readonly root: string }): Promise<void> {
      root = options.root ?? config.root
      manifest = await (options.manifest ?? (() => loadManifest(root)))()
      regenerate()
    },
    configureServer(server: WatchedServer): void {
      const report = options.onRouterError ?? reportOnStderr
      const onChange = (file: string): void => {
        if (!isRouted(file)) return
        try {
          regenerate()
        } catch (cause) {
          // This listener runs inside chokidar's emit, so a throw is an
          // uncaught exception that takes the dev server down rather than an
          // error overlay. Creating a capitalised pane file, adding a second
          // flow.ts for an existing id, or deleting the root AGENT.ts all
          // raise a refused tree; a full disk or a read-only checkout raises a
          // filesystem refusal. Either one leaves the previous tables on disk
          // and is reported; anything else is a defect and still propagates.
          if (cause instanceof RouterError) {
            report(cause)
            return
          }
          if (!isFilesystemRefusal(cause)) throw cause
          reportRefusalOnStderr(cause)
        }
      }
      server.watcher.on("add", onChange)
      server.watcher.on("unlink", onChange)
    },
    resolveId(id: string): string | null {
      return id === brandModuleId || id === manifestModuleId ? `\0${id}` : null
    },
    load(id: string): string | null {
      if (id === `\0${brandModuleId}`) return brandCss(required().brand)
      if (id === `\0${manifestModuleId}`) return `export default ${JSON.stringify(required())}`
      return null
    }
  } satisfies CreateAppPlugin & Plugin
  return plugin
}
