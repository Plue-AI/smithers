/**
 * `CreateApp` is the one call an app's PACKAGE.ts makes, so what it derives —
 * the manifest defaults and the five target declarations — is the app's whole
 * build surface. The assertions read target attributes and drive the routes
 * bin with its declared arguments to check parity with the Vite plugin.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Target from "@smthrs/targets/Target"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { type Brand, CreateApp } from "../src/index.ts"
import { runRoutesBin } from "../src/routesBin.ts"
import { createApp } from "../src/vite.ts"

const packageRoot = fileURLToPath(new URL("..", import.meta.url))

const brand: Brand = { name: "Ledger", tokens: { accent: "#5288c2" } }

const app = (overrides: Partial<Parameters<typeof CreateApp>[0]> = {}) =>
  CreateApp({
    name: "ledger",
    brand,
    deploy: { cloudflare: { workerName: "ledger-worker", domain: "ledger.example.com" } },
    ...overrides
  })

describe("manifest", () => {
  it("fills the directory layout, the navigation, and the wrangler path", () => {
    expect(app().manifest).toEqual({
      name: "ledger",
      brand,
      nav: [],
      dirs: { app: "app", flows: "flows", tools: "tools" },
      deploy: {
        cloudflare: {
          workerName: "ledger-worker",
          domain: "ledger.example.com",
          config: "worker/wrangler.jsonc"
        }
      }
    })
  })

  it("takes a partial dirs override without losing the other two", () => {
    expect(app({ dirs: { app: "site" } }).manifest.dirs).toEqual({ app: "site", flows: "flows", tools: "tools" })
  })

  it("keeps a declared wrangler config and navigation", () => {
    const nav = [{ label: "Operate", items: [{ label: "Logs", href: "/operate/logs", icon: "scroll" }] }]
    const targets = app({
      nav,
      deploy: { cloudflare: { workerName: "w", domain: "d.example.com", config: "infra/wrangler.jsonc" } }
    })
    expect(targets.manifest.nav).toEqual(nav)
    expect(targets.manifest.deploy.cloudflare.config).toBe("infra/wrangler.jsonc")
  })
})

describe("targets", () => {
  it.each([
    [{}, ["--app", "app", "--flows", "flows", "--tools", "tools"]],
    [{ app: "site" }, ["--app", "site", "--flows", "flows", "--tools", "tools"]],
    [
      { app: "src/site", flows: "src/pipelines", tools: "src/kit" },
      ["--app", "src/site", "--flows", "src/pipelines", "--tools", "src/kit"]
    ]
  ])("passes the resolved directory layout %j to the routes bin", (dirs, args) => {
    const attrs = Target.metadata(app({ dirs }).routes).attrs as { readonly args: ReadonlyArray<string> }
    expect(attrs.args).toEqual(args)
  })

  it("generates the same custom-directory tables as the Vite plugin", async () => {
    const targets = app({ dirs: { app: "src/site", flows: "src/pipelines", tools: "src/kit" } })
    const attrs = Target.metadata(targets.routes).attrs as { readonly args?: ReadonlyArray<string> }
    const root = mkdtempSync(join(tmpdir(), "smthrs-package-routes-"))
    try {
      for (
        const [path, contents] of Object.entries({
          "AGENT.ts": "export const Agent = {}\n",
          "SANDBOX.ts": "export const Sandbox = {}\n",
          "TOOLS.ts": "export const Tools = {}\n",
          "src/site/page.tsx": "export default () => null\n",
          "src/site/panes/balances.tsx": "export const Pane = {}\n",
          "src/pipelines/chat/flow.ts": "export const Flow = {}\n"
        })
      ) {
        const full = join(root, path)
        mkdirSync(dirname(full), { recursive: true })
        writeFileSync(full, contents)
      }
      const out: Array<string> = []
      const err: Array<string> = []
      expect(runRoutesBin(attrs.args ?? [], {
        cwd: root,
        io: { out: (line) => out.push(line), err: (line) => err.push(line) }
      })).toBe(0)
      expect(err).toEqual([])
      const routes = readFileSync(join(root, "routes.gen.ts"), "utf8")
      const ui = readFileSync(join(root, "routes.ui.gen.ts"), "utf8")

      await createApp({ manifest: async () => targets.manifest }).configResolved({ root })
      expect(routes).toBe(readFileSync(join(root, "routes.gen.ts"), "utf8"))
      expect(ui).toBe(readFileSync(join(root, "routes.ui.gen.ts"), "utf8"))
      expect(out).toEqual(["routes: 1 pages, 1 panes, 1 flows"])
      expect(routes).toContain("src/pipelines/chat/flow.ts")
      expect(ui).toContain("src/site/page.tsx")
      expect(ui).toContain("src/site/panes/balances.tsx")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("generates both route tables from the package's own bin", () => {
    const attrs = Target.metadata(app().routes).attrs as {
      readonly bin: { readonly package: string; readonly bin: string }
      readonly changes: ReadonlyArray<string>
    }
    expect(attrs.bin).toMatchObject({ package: "@smthrs/create-app", bin: "smithers-routes" })
    expect(attrs.changes).toEqual(["routes.gen.ts", "routes.ui.gen.ts"])
  })

  it("keys the route tables on the routed files and PACKAGE.ts, and on nothing else", () => {
    const attrs = Target.metadata(app({ dirs: { app: "site", flows: "pipelines" } }).routes).attrs as {
      readonly data: readonly [ReadonlyArray<{ readonly pattern: string }>, { readonly path: string }]
    }
    expect(attrs.data[0].map((glob) => glob.pattern)).toEqual([
      "site/**/page.tsx",
      "site/layout.tsx",
      "site/panes/*.tsx",
      "pipelines/**/flow.ts",
      "**/AGENT.ts",
      "**/SANDBOX.ts",
      "**/TOOLS.ts"
    ])
    expect(attrs.data[1].path).toBe("//PACKAGE.ts")
  })

  it("serves on the port it waits for, with the network open", () => {
    const attrs = Target.metadata(app().dev).attrs as {
      readonly args: ReadonlyArray<string>
      readonly readiness: { readonly port: number }
      readonly sandbox: { readonly network: boolean }
    }
    expect(attrs.args).toEqual(["--port", "5173"])
    expect(attrs.readiness.port).toBe(5173)
    expect(attrs.sandbox.network).toBe(true)
  })

  // Vite reads `index.html` and `public/` by convention rather than through an
  // import, so nothing infers them from the source trees. Until this case the
  // declaration named neither, and editing the entry document left the
  // declared inputs of `dev` and `build` byte-identical.
  it.each([["dev"], ["build"]] as const)("keys %s on the HTML entry and the public assets", (target) => {
    const attrs = Target.metadata(app({ dirs: { app: "site", flows: "pipelines" } })[target]).attrs as {
      readonly data: readonly [ReadonlyArray<{ readonly pattern: string }>, ...Array<unknown>]
    }
    expect(attrs.data[0].map((glob) => glob.pattern)).toEqual([
      "site/**",
      "pipelines/**",
      "tools/**",
      "worker/**",
      "src/**",
      "index.html",
      "public/**"
    ])
  })

  it("declares the HTML entry every template ships as a build input", () => {
    const patterns = (Target.metadata(app().build).attrs as {
      readonly data: readonly [ReadonlyArray<{ readonly pattern: string }>, ...Array<unknown>]
    }).data[0].map((glob) => glob.pattern)
    for (const template of readdirSync(join(packageRoot, "template"))) {
      expect([template, existsSync(join(packageRoot, "template", template, "index.html"))]).toEqual([template, true])
    }
    expect(patterns).toContain("index.html")
  })

  // `deploy` runs wrangler without `--config`, so the artifact it needs is the
  // redirect the vite plugin writes outside `dist`. Until this case the build
  // declared only `dist`, and a cache restore into a clean checkout could not
  // supply deploy's prerequisite.
  it("builds into dist and the wrangler deploy redirect", () => {
    const attrs = Target.metadata(app().build).attrs as {
      readonly outDirs: ReadonlyArray<string>
      readonly outFiles: ReadonlyArray<string>
    }
    expect(attrs.outDirs).toEqual(["dist"])
    expect(attrs.outFiles).toEqual([".wrangler/deploy/config.json"])
  })

  it("gates deploy on the build and requires approval and both credentials", () => {
    const attrs = Target.metadata(app().deploy).attrs as {
      readonly args: ReadonlyArray<string>
      readonly env: Readonly<Record<string, string>>
      readonly approval: string
      readonly gates: ReadonlyArray<unknown>
      readonly secrets: ReadonlyArray<{
        readonly secret: { readonly env: string }
        readonly audiences: ReadonlyArray<string>
      }>
    }
    // No `--config`: wrangler follows the vite plugin's deploy redirect only
    // when the flag is absent.
    expect(attrs.args).toEqual(["deploy"])
    // An HTTPS audience is reachable with its secret substituted only through
    // the brokered origin; wrangler takes its API base from this variable.
    expect(attrs.env).toEqual({
      CLOUDFLARE_API_BASE_URL: "{smthrs:secret-origin:https://api.cloudflare.com}/client/v4"
    })
    expect(attrs.approval).toBe("required")
    expect(attrs.gates).toHaveLength(1)
    // Re-pinned 2026-09-01. Until 74a8ad64ca the scaffold declared both
    // credentials as bare `S.Secret` sources and this read `secret.env`
    // directly. That commit bound each one to the Cloudflare API origin with
    // `S.HttpSecret`, which nests the source under `secret` and adds
    // `audiences`, so the assertion reads the new shape and pins the binding
    // the commit added rather than only the names it kept.
    expect(attrs.secrets.map((credential) => credential.secret.env)).toEqual([
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_ACCOUNT_ID"
    ])
    expect(attrs.secrets.map((credential) => credential.audiences)).toEqual([
      ["https://api.cloudflare.com"],
      ["https://api.cloudflare.com"]
    ])
  })
})
