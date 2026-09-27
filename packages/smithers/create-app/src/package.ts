/**
 * The Node half of the authoring surface: `CreateApp`.
 *
 * `CreateApp` turns one declaration into the app manifest plus the four
 * targets an app needs — regenerate the route tables, serve, build, deploy.
 * Every target is an ordinary `@smthrs/targets` rule, so an app runs on the
 * `smithers-build` CLI without a new target kind.
 *
 * Only `PACKAGE.ts` imports this module. The browser and Worker bundles import
 * `@smthrs/create-app/app`, which pulls in no build rules.
 *
 * @since 0.1.0
 */

import { Smithers as S } from "@smthrs/targets"
import { type AppDirs, type AppManifest, type Brand, type CloudflareDeploy, defaultDirs, type NavGroup } from "./app.ts"

/**
 * What `CreateApp` is given: the brand, the navigation, the source layout, and
 * where the app deploys.
 *
 * @category models
 * @since 0.1.0
 */
export interface CreateAppOptions {
  readonly name: string
  readonly brand: Brand
  readonly nav?: ReadonlyArray<NavGroup>
  readonly dirs?: Partial<AppDirs>
  readonly deploy: { readonly cloudflare: CloudflareDeploy }
}

/**
 * What `CreateApp` returns: the manifest the Vite plugin serves, and the four
 * targets `PACKAGE.ts` puts in its target map.
 *
 * @category models
 * @since 0.1.0
 */
export interface AppTargets {
  readonly manifest: AppManifest
  /** Regenerates `routes.gen.ts` and `routes.ui.gen.ts`; checks drift without `--write`. */
  readonly routes: ReturnType<typeof S.Generate>
  /** `vite` with workerd in the loop. */
  readonly dev: ReturnType<typeof S.Shell.Serve>
  /** `vite build`, writing `dist` and the `.wrangler/deploy/config.json` redirect. */
  readonly build: ReturnType<typeof S.Shell.Build>
  /** `wrangler deploy`: approval required, network on, credentials as named secrets. */
  readonly deploy: ReturnType<typeof S.Shell.Run>
}

/** The wrangler config every app gets when it declares no path of its own. */
const defaultWranglerConfig = "worker/wrangler.jsonc"

/** The port `dev` serves on and waits for. */
const devPort = 5173

/** Where the vite plugin writes the file `wrangler deploy` follows to the built Worker. */
const wranglerDeployRedirect = ".wrangler/deploy/config.json"

/**
 * Declares a Smithers app.
 *
 * @example
 * ```ts
 * import { CreateApp } from "@smthrs/create-app"
 * import { Smithers as S } from "@smthrs/targets"
 *
 * export const App = CreateApp({
 *   name: "ledger",
 *   brand: { name: "Ledger", tokens: { accent: "#5288c2" } },
 *   deploy: { cloudflare: { workerName: "ledger", domain: "ledger.example.com" } }
 * })
 *
 * export const Package = S.Package({
 *   targets: { routes: App.routes, dev: App.dev, build: App.build, deploy: App.deploy }
 * })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const CreateApp = (options: CreateAppOptions): AppTargets => {
  const dirs: AppDirs = { ...defaultDirs, ...options.dirs }
  const cloudflare: Required<CloudflareDeploy> = { config: defaultWranglerConfig, ...options.deploy.cloudflare }
  const manifest: AppManifest = {
    name: options.name,
    brand: options.brand,
    nav: options.nav ?? [],
    dirs,
    deploy: { cloudflare }
  }

  // Everything the router reads. `routes` keys on this set, so adding a page,
  // a pane, a flow, or a layer file invalidates the generated tables and
  // nothing else does.
  const routed = S.glob([
    `${dirs.app}/**/page.tsx`,
    `${dirs.app}/layout.tsx`,
    `${dirs.app}/panes/*.tsx`,
    `${dirs.flows}/**/flow.ts`,
    `${dirs.flows}/**/flow.mdx`,
    "**/AGENT.ts",
    "**/SANDBOX.ts",
    "**/TOOLS.ts"
  ])
  // Everything Vite reads. The two entries after the source trees are the
  // inputs Vite takes by convention rather than by import: `index.html` is the
  // entry it builds the browser bundle from, and `public/` is copied into
  // `dist` verbatim. Without them, editing the title or an entry script leaves
  // the declared inputs of `dev` and `build` unchanged. Both templates take
  // Vite's defaults for `root` and `publicDir`; an app that moves either in
  // its `vite.config.ts` declares the new path itself.
  const sources = S.glob([
    `${dirs.app}/**`,
    `${dirs.flows}/**`,
    `${dirs.tools}/**`,
    "worker/**",
    "src/**",
    "index.html",
    "public/**"
  ])
  const wrangler = S.file(`//${cloudflare.config}`)

  // The generator is the package's own `smithers-routes` bin, resolved from the
  // app's node_modules, so an app never names a path inside this package.
  const routes = S.Generate({
    bin: S.NodeModule.Bin("@smthrs/create-app", "smithers-routes"),
    args: ["--app", dirs.app, "--flows", dirs.flows, "--tools", dirs.tools],
    data: [routed, S.file("//PACKAGE.ts")],
    changes: ["routes.gen.ts", "routes.ui.gen.ts"]
  })

  const dev = S.Shell.Serve({
    bin: S.NodeModule.Bin("vite"),
    args: ["--port", String(devPort)],
    data: [sources, wrangler, S.file("//vite.config.ts"), routes],
    readiness: { port: devPort },
    stop: { signal: "SIGTERM", grace: "5s" },
    sandbox: { network: true }
  })

  const build = S.Shell.Build({
    bin: S.NodeModule.Bin("vite"),
    args: ["build"],
    data: [sources, wrangler, S.file("//vite.config.ts"), routes],
    outDirs: ["dist"],
    // `deploy` reads the redirect the vite plugin writes outside `dist`, so a
    // build restored from cache has to bring it back with the bundle.
    outFiles: [wranglerDeployRedirect]
  })

  // No `--config`: wrangler follows the vite plugin's
  // `.wrangler/deploy/config.json` redirect only when the flag is absent, and
  // that redirect points at the built Worker bundle. The source
  // `wrangler.jsonc` is the vite plugin's input, not wrangler's. The redirect
  // is a declared output of `build`, so gating on `build` restores it too.
  //
  // The proxy cannot substitute inside an HTTPS tunnel, so wrangler reaches
  // the Cloudflare API through the brokered loopback origin, which forwards
  // over TLS and replaces the token and account placeholders on the way.
  const deploy = S.Shell.Run({
    bin: S.NodeModule.Bin("wrangler"),
    args: ["deploy"],
    env: { CLOUDFLARE_API_BASE_URL: `${S.SecretOrigin("https://api.cloudflare.com")}/client/v4` },
    gates: [build],
    secrets: [
      S.HttpSecret(S.Secret("CLOUDFLARE_API_TOKEN"), ["https://api.cloudflare.com"]),
      S.HttpSecret(S.Secret("CLOUDFLARE_ACCOUNT_ID"), ["https://api.cloudflare.com"])
    ],
    sandbox: { network: true },
    approval: "required"
  })

  return { manifest, routes, dev, build, deploy }
}
