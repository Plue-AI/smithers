import * as AgentApiRoutes from "@smthrs/rpc/AgentApiRoutes"
/*
 * The host parity matrix (docs/web-mode/PLAN.md §6).
 *
 * Two registries are built from the SAME two functions the servers call —
 * `cloudCapabilities` for the Worker, `localCapabilities` for the Bun server —
 * so what this file proves about the web and native catalogs cannot drift from
 * what production emits. Per flow:
 *
 *  (a) a native-only flow (registry.ts `nativeOnly`) is absent from the cloud
 *      registry, its slash tree, the model's catalog and the recommendations;
 *  (b) every cloud-present flow whose seam calls `/api/*` or `/api/cloud/*`
 *      reaches a path the Worker's `PLATFORM_PROXY_RULES` allowlists, with
 *      the method the seam uses, and (b\u2032) every allowlisted family is one
 *      some seam builds;
 *  (c) `box.terminal` is present exactly when `cloud.terminal` is.
 *
 * Drift fails loudly: a capability the schema does not know, a capability no
 * host emits, a new `local.*` flow leaking onto the web — none needs a test
 * edit to be caught.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { StorageApi } from "@tanstack/db"
import { afterAll, describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { createElement } from "react"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { PLATFORM_PROXY_RULES, platformProxyRuleCovers } from "smithers-server/index"
import { INSTALLATIONS_PATH } from "smithers-server/githubAppInstall"
import { RuntimeCapabilitySchema } from "@smthrs/rpc/AppBootstrap"
import type { AppBootstrap, RuntimeCapability } from "@smthrs/rpc/AppBootstrap"
import { cloudCapabilities, localCapabilities } from "@smthrs/rpc/HostCapabilities"
import App from "../App"
import { ControllerTestProvider } from "../ControllerContext"

import type { AgentPort } from "../runtime/AgentPort"
import { createAppController } from "../state/AppController"
import type { AppController } from "../state/AppController"
import { createAppStore } from "../state/AppStore"
import { scopedControllers } from "../state/ControllerTestScope"
import type { CommandState, FlowEntry } from "./registry"
import { nameOf, nativeOnly, recommendedNames } from "./registry"

/* (a″) mounts the shell; the same register/unregister the component tests use. */
GlobalRegistrator.register()

/**
 * Nets capture-phase `keydown` registrations against removals on the shared
 * document. Every controller installs one (state/controller/tabs.ts
 * `installKeyboard`, via AppController's `onDispose`), so an undisposed
 * fixture keeps steering key events for every test that follows it in this
 * process. The hygiene test at the bottom asserts the count returns to zero.
 */
const trackCaptureKeydown = (target: Document): (() => number) => {
  let open = 0
  const add = target.addEventListener.bind(target)
  const remove = target.removeEventListener.bind(target)
  const capturing = (options?: boolean | AddEventListenerOptions | EventListenerOptions): boolean =>
    options === true || (typeof options === "object" && options !== null && options.capture === true)
  target.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    if (type === "keydown" && capturing(options)) open += 1
    add(type, listener, options)
  }) as Document["addEventListener"]
  target.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
    if (type === "keydown" && capturing(options)) open -= 1
    remove(type, listener, options)
  }) as Document["removeEventListener"]
  return () => open
}

const openCaptureKeydown = trackCaptureKeydown(document)

afterAll(async () => {
  const { disposeCodeViewPool } = await import("@smthrs/ui/adapters/code-view")
  disposeCodeViewPool()
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await GlobalRegistrator.unregister()
})

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const unavailableAgent: AgentPort = {
  available: false,
  startTurn: async () => ({ status: "error", message: "unavailable" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}


/** Per-test fixtures; the scope disposes each one in its own `afterEach`. */
const scopedController = scopedControllers()

const controllerFor = async (bootstrap?: AppBootstrap): Promise<AppController> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  return scopedController(store, unavailableAgent, { bootstrap })
}

/*
 * The three registries are built once and read by every parity test, so they
 * outlive `afterEach` and are released in the describe's `afterAll` instead —
 * before the file-level hook drops the code-view pool and the document they
 * hold listeners on.
 */
const sharedControllers = new Set<AppController>()

const sharedControllerFor = async (bootstrap?: AppBootstrap): Promise<AppController> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableAgent, { bootstrap })
  sharedControllers.add(controller)
  return controller
}

const disposeSharedControllers = async (): Promise<void> => {
  const errors: unknown[] = []
  for (const controller of sharedControllers) {
    try {
      await controller.dispose()
    } catch (error) {
      errors.push(error)
    }
  }
  sharedControllers.clear()
  if (errors.length > 0) throw new AggregateError(errors, "Shared controller fixture cleanup failed")
}

const cloudBootstrap = (capabilities: ReadonlyArray<RuntimeCapability>): AppBootstrap => ({
  apiVersion: 1,
  host: "cloud",
  version: "test",
  buildSha: "cloud",
  capabilities: [...capabilities],
  authFlow: "redirect",
  sandbox: null
})

const localBootstrap = (capabilities: ReadonlyArray<RuntimeCapability>): AppBootstrap => ({
  apiVersion: 1,
  host: "local",
  version: "test",
  buildSha: "local",
  capabilities: [...capabilities],
  authFlow: "native-handoff",
  sandbox: { platform: "darwin", mode: "enforced" }
})

/** The Worker with every supported capability, including the W4 terminal relay. */
const WEB = cloudBootstrap(cloudCapabilities({ identity: true, cloud: true, agent: true, balance: true, overview: true, plans: true, portal: true, checkout: true, terminal: true, browser: true }))
/** The Bun server under the desktop shell, with a cloud upstream, the agent, identity and manual paths. */
const NATIVE = localBootstrap(localCapabilities({ agent: true, identity: true, cloud: true, balance: true, overview: true, plans: true, browser: true, nativeShell: true }))

/** Every command state the recommendation rule distinguishes. */
const STATES: ReadonlyArray<CommandState> = (["chat", "world", "connectors", "flows"] as const).flatMap((surface) =>
  [true, false].flatMap((signedOut) =>
    [true, false].flatMap((typing) =>
      [true, false].map((hasConnectors) => ({ surface, typing, hasConnectors, admin: false, signedOut }))
    )
  )
)

const read = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")

/**
 * The registry source: the Flows.ts aggregator, every namespace module under
 * ./entries and every shared operation module (`@smthrs/ui/app-operations`),
 * read together so a flow declared in any module counts.
 */
const registrySources = (): string => {
  const entries = fileURLToPath(new URL("./entries/", import.meta.url))
  const shared = fileURLToPath(new URL(".", import.meta.resolve("@smthrs/ui/app-operations")))
  return [
    read("./Flows.ts"),
    ...readdirSync(entries).sort().map((file) => read(`./entries/${file}`)),
    ...readdirSync(shared).sort().map((file) => readFileSync(`${shared}${file}`, "utf8"))
  ].join("\n")
}

/** Source with block and line comments removed, so a documented example path is not mistaken for a call. */
const uncommented = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1")

/**
 * The flows that reach each seam, read the way the app wires them: a flow's
 * handler calls `actions.<method>`, and AppController binds `<method>:
 * <seam>.<fn>`. Source-derived on purpose — the wiring is the truth this
 * matrix must follow, and a renamed action fails here rather than drifting.
 */
const seamsByFlow = (): Map<string, ReadonlySet<string>> => {
  const flows = uncommented(registrySources())
  const controller = uncommented(read("../state/AppController.ts"))
  const actionSeam = new Map<string, string>()
  for (const match of controller.matchAll(/^\s+(\w+): (\w+Seam)\.\w+,?$/gm)) {
    actionSeam.set(match[1] as string, match[2] as string)
  }
  const seamFile = new Map<string, string>()
  // A principal pair wraps the same seam factory without changing its route family.
  for (const match of controller.matchAll(/const (\w+Seam) = (?:actors\.pair\([^\n]*?=>\s*)?(create\w+Seam)\(/g)) {
    const imported = new RegExp(`import \\{[^}]*\\b${match[2]}\\b[^}]*\\} from "\\./seams/(\\w+)"`).exec(controller)
    if (imported?.[1] !== undefined) seamFile.set(match[1] as string, imported[1])
  }
  const out = new Map<string, ReadonlySet<string>>()
  // A chunk is one registered entry. A namespace module's block function
  // opens with `export const`; the shared declarations it holds before its
  // `return [` belong to no entry, so that chunk is dropped like the file head.
  for (const chunk of flows.split(/\n  (?=(?:flow|alias)\()|\nexport const /)) {
    if (!/^(?:flow|alias)\(/.test(chunk)) continue
    const name = /name:\s*"([^"]+)"/.exec(chunk)?.[1]
    if (name === undefined) continue
    const files = new Set<string>()
    for (const match of chunk.matchAll(/actions\.(\w+)/g)) {
      const seam = actionSeam.get(match[1] as string)
      const file = seam === undefined ? undefined : seamFile.get(seam)
      if (file !== undefined) files.add(file)
    }
    out.set(name, files)
  }
  expect(out.size).toBeGreaterThan(100)
  expect(seamFile.size).toBeGreaterThan(10)
  return out
}

/** The API path heads plue serves; a string fragment under one of them is a call. */
const API_HEADS = "repos|user|orgs|notifications|github|admin|billing|cloud-auth|repo|auth|identity|agent|model"

/**
 * The static prefixes of every upstream path a seam file builds, normalized to
 * the Worker's view: `cloud("/user/repos")` and `${ctx.baseUrl}/api/user/repos`
 * both read `/api/user/repos`. A template's dynamic tail is cut at `${`.
 */
const upstreamPaths = (seamFile: string): ReadonlySet<string> => {
  const source = uncommented(read(`../state/seams/${seamFile}.ts`))
  const paths = new Set<string>()
  // Shared route constants are paths too; the seam need not duplicate their literals.
  for (const [name, path] of Object.entries(AgentApiRoutes)) {
    if (typeof path === "string" && path.startsWith("/api/") && source.includes("${" + name + "}")) paths.add(path)
  }
  const pattern = new RegExp(
    "[`\"'](?:\\$\\{ctx\\.baseUrl\\})?(?:/api)?/((?:" + API_HEADS + ")(?:/[a-z0-9-]+)*/?)",
    "g"
  )
  for (const match of source.matchAll(pattern)) paths.add(`/api/${match[1] as string}`)
  return paths
}

/** One path literal normalized to the Worker's view, or undefined when it is not an upstream API path. */
const upstreamHead = new RegExp("^(?:\\$\\{ctx\\.baseUrl\\})?(?:/api)?/((?:" + API_HEADS + ")(?:/[a-z0-9-]+)*/?)")
const upstreamPathOf = (literal: string): string | undefined => {
  const match = upstreamHead.exec(literal)
  return match === null ? undefined : `/api/${match[1] as string}`
}

/**
 * The WRITES a seam file makes with a literal path beside the method — the
 * seams' `sendJson("POST", \`/orgs/${org}/changesets/${id}/land\`)` helper and a
 * `ctx.http(cloud("/github/import"), { method: "POST" })` call — as
 * `METHOD /api/path` pairs. A write whose path is built by a helper
 * (`repoPath(...)`) carries no literal and is not seen here; the path-only
 * extraction above still covers its family. The allowlist names methods per
 * row, so a prefix match alone would pass a DELETE the Worker refuses.
 */
const upstreamWrites = (seamFile: string): ReadonlySet<string> => {
  const source = uncommented(read(`../state/seams/${seamFile}.ts`))
  const writes = new Set<string>()
  for (const match of source.matchAll(/sendJson\(\s*"([A-Z]+)"\s*,\s*([`"'])((?:(?!\2).)*)\2/g)) {
    const path = upstreamPathOf(match[3] as string)
    if (path !== undefined) writes.add(`${match[1] as string} ${path}`)
  }
  for (
    const match of source.matchAll(
      /ctx\.http\(\s*(?:cloud\()?\s*([`"'])((?:(?!\1).)*)\1\s*\)?\s*,\s*\{\s*method:\s*"([A-Z]+)"/g
    )
  ) {
    const path = upstreamPathOf(match[2] as string)
    if (path !== undefined) writes.add(`${match[3] as string} ${path}`)
  }
  return writes
}

/** Every seam file, for the reverse direction: an allowlisted family no seam builds is a door nothing needs. */
const SEAM_FILES: ReadonlyArray<string> = readdirSync(fileURLToPath(new URL("../state/seams/", import.meta.url)))
  .filter((file) => file.endsWith("Seam.ts"))
  .map((file) => file.slice(0, -".ts".length))

const proxied = (path: string, method?: string): boolean =>
  ((method === undefined || method === "GET") && (path === INSTALLATIONS_PATH || path.startsWith(`${INSTALLATIONS_PATH}/`))) ||
  PLATFORM_PROXY_RULES.some((rule) =>
    (method === undefined || rule.methods.includes(method)) && platformProxyRuleCovers(rule, path)
  )

/*
 * Paths a cloud-present flow reaches that the Worker does NOT allowlist today.
 * Attribution is per SEAM FILE (the extraction does not follow a seam's
 * internal call graph), so every flow that reaches the seam is listed even
 * when one method pays. Exact: a fix must remove its row here, and a new gap
 * fails with no row to hide behind.
 *
 * Empty since lane L6: the one row was `/api/admin/github-app/reconcile`,
 * which `GitHubSeam.reconcile` no longer calls — plue#490 gave every
 * repository WRITER `POST /api/repos/{o}/{r}/github/reconcile`, a path the
 * Worker already proxies, so `/github.reconcile` works on the web.
 */
const KNOWN_UNPROXIED: ReadonlyArray<{ readonly path: string; readonly flows: ReadonlyArray<string>; readonly why: string }> = []

describe("host parity — the web and native catalogs against the servers' own capability tables", () => {
  test("balance commands require the read route, not checkout or identity alone", async () => {
    for (const balance of [false, true]) for (const checkout of [false, true]) {
      const controller = await controllerFor(localBootstrap(["identity", ...(balance ? ["billing.balance" as const] : []), ...(checkout ? ["billing.checkout" as const] : [])]))
      expect(controller.commands.find("billing.balance") !== undefined).toBe(balance)
    }
  })
  test("plan, purchase and portal commands follow independent routes", async () => {
    for (const plans of [false, true]) for (const checkout of [false, true]) for (const portal of [false, true]) {
      const controller = await controllerFor(localBootstrap(["identity",
        ...(plans ? ["billing.plans" as const] : []),
        ...(checkout ? ["billing.checkout" as const] : []),
        ...(portal ? ["billing.portal" as const] : [])]))
      expect(controller.commands.find("billing.plans") !== undefined).toBe(plans)
      expect(controller.commands.find("billing.upgrade") !== undefined).toBe(checkout)
      expect(controller.commands.find("billing.portal") !== undefined).toBe(portal)
    }
  })
  const registries = (async () => ({
    web: await sharedControllerFor(WEB),
    native: await sharedControllerFor(NATIVE),
    unknown: await sharedControllerFor()
  }))()

  afterAll(async () => {
    // Settle construction first: a fixture still being built would otherwise
    // register itself after the drain and outlive the file.
    await registries.catch(() => {})
    await disposeSharedControllers()
  })

  /** Every declared non-admin flow: the union of the three registries. */
  const declared = async (): Promise<ReadonlyArray<FlowEntry>> => {
    const { web, native, unknown } = await registries
    const seen = new Map<string, FlowEntry>()
    for (const entry of [...unknown.commands.entries(), ...native.commands.entries(), ...web.commands.entries()]) {
      seen.set(nameOf(entry), entry)
    }
    return [...seen.values()]
  }

  test("(a) a native-only flow is absent from the cloud registry, slash tree, model catalog and recommendations", async () => {
    const { web } = await registries
    const entries = await declared()
    const nativeOnlyNames = entries.filter((entry) => nativeOnly(entry.metadata)).map(nameOf)
    expect(nativeOnlyNames).toContain("cloud.sign-in")
    const webNames = new Set(web.commands.all().map((command) => command.name))
    const slashNames = new Set<string>()
    const walk = (needle: string): void => {
      for (const row of web.commands.slashTree(needle)) {
        if (row.kind === "flow") slashNames.add(row.flow.name)
        else if (row.kind === "namespace") walk(`${row.namespace.id}.`)
      }
    }
    walk("")
    const disclosed = new Set(web.commands.disclosed().map((descriptor) => descriptor.name))
    const recommended = new Set(STATES.flatMap((state) => recommendedNames(state)))
    const leaks = nativeOnlyNames.flatMap((name) => [
      ...(webNames.has(name) ? [`${name} registered on the web`] : []),
      ...(slashNames.has(name) ? [`${name} listed in the web slash tree`] : []),
      ...(disclosed.has(name) ? [`${name} disclosed to the web model`] : []),
      ...(recommended.has(name) ? [`${name} recommended (the rule names it for some state)`] : [])
    ])
    expect(leaks).toEqual([])
  })

  test("(a′) every flow the web registers is one the web can serve", async () => {
    const { web } = await registries
    const misclassified = web.commands.entries().filter((entry) => nativeOnly(entry.metadata)).map(nameOf)
    expect(misclassified).toEqual([])
    // The either/or reads serve the web through Smithers Cloud, and are present.
    const names = web.commands.all().map((command) => command.name)
    expect(names).toContain("files.list")
    expect(names).toContain("files.read")
  })

  test("the host-scoped flows exist exactly where their host is", async () => {
    const { web, native, unknown } = await registries
    for (const name of ["app.download", "app.download.prompt"]) {
      expect(`${name} on web: ${web.commands.find(name) !== undefined}`).toBe(`${name} on web: true`)
      expect(`${name} on native: ${native.commands.find(name) !== undefined}`).toBe(`${name} on native: false`)
      expect(`${name} without a host: ${unknown.commands.find(name) !== undefined}`).toBe(`${name} without a host: false`)
    }
  })

  test("(b) every cloud-present flow's seam reaches only paths the Worker allowlists", async () => {
    const { web } = await registries
    const flowSeams = seamsByFlow()
    /*
     * The funnel's first list is not a flow: the controller loads the cloud
     * repository inventory on sign-in (AppController.ts
     * reloadRepositoriesWhenSignedIn → repositoriesSeam.loadRepositories), so
     * that seam is checked as if a flow reached it.
     */
    const SIGN_IN_LOADS: ReadonlyArray<readonly [string, ReadonlySet<string>]> = [
      ["(sign-in load: loadRepositories)", new Set(["RepositoriesSeam"])],
      /*
       * The tree caret: repo.tree binds actions.toggleRepoTree, a
       * controller pair over RepoTreeSeam (AppController.ts
       * createSidebarController(context, select(repoTreeSeam))), which the
       * `<action>: <seam>.<fn>` binding scan above does not see. A cloud
       * workspace copy's caret reads GET /api/repos/{o}/{r}/workspaces/{id}/files.
       */
      ["repo.tree (tree caret: toggleRepoTree -> RepoTreeSeam)", new Set(["RepoTreeSeam"])]
    ]
    const pathCache = new Map<string, ReadonlySet<string>>()
    const writeCache = new Map<string, ReadonlySet<string>>()
    const gaps = new Map<string, Set<string>>()
    let checked = 0
    const reached: Array<readonly [string, ReadonlySet<string>]> = [
      ...SIGN_IN_LOADS,
      ...web.commands.all().flatMap((item) => {
        const seams = flowSeams.get(item.name)
        return seams === undefined ? [] : [[item.name, seams] as const]
      })
    ]
    for (const [name, seams] of reached) {
      const item = { name }
      for (const seam of seams) {
        const paths = pathCache.get(seam) ?? upstreamPaths(seam)
        pathCache.set(seam, paths)
        for (const path of paths) {
          checked += 1
          if (proxied(path)) continue
          const flows = gaps.get(path) ?? new Set<string>()
          flows.add(item.name)
          gaps.set(path, flows)
        }
        // The writes with a literal path: the method must be on the row too.
        const writes = writeCache.get(seam) ?? upstreamWrites(seam)
        writeCache.set(seam, writes)
        for (const write of writes) {
          const [method, path] = write.split(" ") as [string, string]
          checked += 1
          if (proxied(path, method)) continue
          const flows = gaps.get(path) ?? new Set<string>()
          flows.add(item.name)
          gaps.set(path, flows)
        }
      }
    }
    // The extraction saw the real seams: the funnel's first list, the file reads, and a change landing's method.
    expect(checked).toBeGreaterThan(50)
    expect([...(pathCache.get("RepositoriesSeam") ?? [])]).toContain("/api/user/repos")
    expect([...(pathCache.get("FilesSeam") ?? [])]).toContain("/api/repos/")
    expect([...(pathCache.get("RepoTreeSeam") ?? [])]).toContain("/api/repos/")
    expect([...(writeCache.get("ChangeSeam") ?? [])]).toContain("POST /api/orgs/")
    const found = [...gaps.entries()]
      .map(([path, flows]) => ({ path, flows: [...flows].sort() }))
      .sort((left, right) => left.path.localeCompare(right.path))
    expect(found).toEqual(
      KNOWN_UNPROXIED.map(({ path, flows }) => ({ path, flows: [...flows].sort() }))
        .sort((left, right) => left.path.localeCompare(right.path))
    )
  })

  /*
   * The reverse of (b): the allowlist is a capability grant (the bridge hands
   * the page whatever the platform answers, a minted PAT included), so every
   * family it opens must be one a seam builds a path under today. A lane adds
   * its row in the same commit as the seam that calls it, never ahead of it.
   */
  test("(b\u2032) every allowlisted family is a path some seam builds", () => {
    const built = new Set(SEAM_FILES.flatMap((seam) => [...upstreamPaths(seam)]))
    expect(SEAM_FILES.length).toBeGreaterThan(10)
    const unreached = PLATFORM_PROXY_RULES.filter((rule) =>
      ![...built].some((path) => platformProxyRuleCovers(rule, path))
    ).map((rule) => `${rule.methods.join("|")} ${rule.exact ?? rule.prefix}`)
    expect(unreached).toEqual([])
    // The two rows the W0 hunk opened for lanes that had not landed are gone.
    expect(proxied("/api/user/tokens")).toBe(false)
    expect(proxied("/api/user/provider-connections")).toBe(true)
  })

  test("(c) box.terminal is present exactly when cloud.terminal is", async () => {
    const withRelay = await controllerFor(
      cloudBootstrap(cloudCapabilities({ identity: true, cloud: true, agent: true, checkout: false, terminal: true }))
    )
    const withoutRelay = await controllerFor(
      cloudBootstrap(cloudCapabilities({ identity: true, cloud: true, agent: true, checkout: false, terminal: false }))
    )
    const nativeOnline = await controllerFor(NATIVE)
    const nativeOffline = await controllerFor(
      localBootstrap(localCapabilities({ agent: true, identity: false, cloud: false }))
    )
    const has = (controller: AppController): boolean => controller.commands.find("box.terminal") !== undefined
    expect(has(withRelay)).toBe(true)
    expect(has(withoutRelay)).toBe(false)
    expect(has(nativeOnline)).toBe(true)
    expect(has(nativeOffline)).toBe(false)
    expect(withRelay.bootstrap?.capabilities).toContain("cloud.terminal")
    expect(withoutRelay.bootstrap?.capabilities).not.toContain("cloud.terminal")
  })

  test("drift: every capability a flow declares is one the bootstrap schema knows", () => {
    const source = registrySources()
    // "practice" is the bundled practice repository (registry.ts FlowCapability): a client-only door no bootstrap names.
    const known = new Set<string>([...RuntimeCapabilitySchema.options, "practice"])
    const named = new Set<string>()
    for (const match of source.matchAll(/\bruntime(?:Any)?:\s*\[([^\]]*)\]/g)) {
      for (const literal of (match[1] as string).matchAll(/"([^"]+)"/g)) named.add(literal[1] as string)
    }
    expect(named.size).toBeGreaterThan(5)
    expect([...named].filter((capability) => !known.has(capability))).toEqual([])
    const hosts = new Set<string>()
    for (const match of source.matchAll(/\bhosts:\s*\[([^\]]*)\]/g)) {
      for (const literal of (match[1] as string).matchAll(/"([^"]+)"/g)) hosts.add(literal[1] as string)
    }
    expect([...hosts].filter((host) => host !== "cloud" && host !== "local")).toEqual([])
  })

  test("drift: every capability the schema knows has a host row", () => {
    const productSource = readFileSync(fileURLToPath(new URL("../../../../../packages/backend/internal/compose/bootstrap.go", import.meta.url)), "utf8")
    const productCapabilities = [...productSource.matchAll(/result\.Capabilities = append\(result\.Capabilities, "([^"]+)"\)/g)]
      .flatMap(match => { const parsed = RuntimeCapabilitySchema.safeParse(match[1]); return parsed.success ? [parsed.data] : [] })
    expect(productCapabilities.length).toBeGreaterThan(0)
    const everything = new Set<RuntimeCapability>([
      ...productCapabilities,
      ...cloudCapabilities({ identity: true, cloud: true, agent: true, checkout: true, terminal: true, browser: true }),
      ...localCapabilities({ agent: true, identity: true, cloud: true, browser: true, nativeShell: true })
    ])
    /* Every capability the schema names is emitted by some host; an orphan fails here. */
    const orphans = RuntimeCapabilitySchema.options.filter((capability) => !everything.has(capability))
    expect(orphans).toEqual([])
  })

  test("the Worker never claims a native door", () => {
    for (const identity of [true, false]) {
      for (const cloud of [true, false]) {
        const emitted = cloudCapabilities({ identity, cloud, agent: true, checkout: true, terminal: true })
        expect(emitted.filter((capability) => capability.startsWith("local.") || capability === "cloud.pat")).toEqual([])
      }
    }
  })

  /*
   * The rendered surface half of (a): the shell mounted under the Worker's
   * bootstrap, as a signed-out visitor sees it (the opening message's CTA and
   * the download button are in the DOM), names no flow the web registry
   * lacks — in its `data-flow` controls or in the `data-flows` manifest on
   * `.app-shell`, which is the web catalog and nothing native.
   */
  /*
   * The signed-in half of the sweep: the cards a web session renders carry
   * their own controls, and a card bound to a flow the web registry lacks is a
   * dead control (the pointer path drops an unregistered name silently). The
   * workspace card is the one whose act rides a host door — the terminal
   * tunnel — so it is the card in the transcript here.
   */
  test("(a‴) a signed-in web page with a workspace card and a TypeScript file card renders no control bound to a flow the web registry lacks", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = scopedController(store, unavailableAgent, {
      bootstrap: WEB,
      fetchImpl: async () =>
        new Response(JSON.stringify({ status: "error" }), { status: 404, headers: { "content-type": "application/json" } })
    })
    await controller.adoptSession({ state: "signed-in", login: "codeplanesmithers", admin: false })
    store.dispatch({
      type: "card.upsert",
      actor: "system",
      card: {
        id: "workspace-ws-1",
        kind: "workspace",
        title: "review · will/smithers",
        status: "active",
        createdAt: 0,
        ordinal: 0,
        payload: {
          workspaceId: "ws-1",
          repo: "will/smithers",
          name: "review",
          targetBookmark: "main",
          status: "running",
          provisioningStage: null,
          suspendedAt: null,
          bookmarkHead: { changeId: "qupxosqw", commitId: "c0ffee1" },
          sessions: [{ id: "sess-1", status: "running", createdAt: null }]
        }
      }
    })
    /*
     * The file card's pointer gestures are bindings to code.hover /
     * code.definition, whose door is the workspace LSP tunnel
     * (`runtime: ["cloud.terminal"]`, which this bootstrap holds): a
     * TypeScript card is in the sweep so every binding it renders is checked
     * against the web catalog. The surface is a lazy chunk, so the sweep
     * waits for it.
     */
    store.dispatch({
      type: "card.upsert",
      actor: "system",
      card: {
        id: "file-will/smithers-src/app.ts",
        kind: "file",
        title: "File · will/smithers · src/app.ts",
        status: "active",
        createdAt: 0,
        ordinal: 1,
        payload: { repo: "will/smithers", path: "src/app.ts", content: "export const answer: number = 42\n", truncated: false }
      }
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    flushSync(() => root.render(createElement(ControllerTestProvider, { controller, children: createElement(App) })))
    try {
      for (let tick = 0; tick < 600 && host.querySelector(".code-surface") === null; tick += 1) await new Promise((resolve) => setTimeout(resolve, 10))
      expect(host.querySelector(".code-surface")).not.toBeNull()
      // This checks command bindings, not highlighting. The page's pool is
      // explicitly disposed in afterAll, including unfinished initialization.
      const webNames = new Set(controller.commands.all().map((command) => command.name))
      const rendered = [
        ...new Set([
          ...[...host.querySelectorAll("[data-flow]")].map((el) => el.getAttribute("data-flow") ?? ""),
          ...[...host.querySelectorAll("[data-flow-activate]")].map((el) => el.getAttribute("data-flow-activate") ?? "")
        ])
      ]
      // Both cards are on the page: the session act and the file surface are in the sweep.
      expect(host.querySelector('[data-kind="workspace"]')).not.toBeNull()
      expect(host.querySelector('[data-kind="file"]')).not.toBeNull()
      expect(rendered).toContain("box.session.destroy")
      expect(rendered.filter((name) => !webNames.has(name))).toEqual([])
      // The tunnel is open here, so the code-intel gesture is a live web binding — never developer copy about a missing host.
      const file = host.querySelector('[data-kind="file"]')!
      expect(webNames.has("code.hover")).toBe(true)
      expect(file.textContent).not.toContain("needs the native app")
    } finally {
      flushSync(() => root.unmount())
      await controller.dispose()
      host.remove()
    }
  })

  test("(a″) the web DOM's data-flow controls and data-flows manifest name only web-registered flows", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = scopedController(store, unavailableAgent, {
      bootstrap: WEB,
      // The download button renders only while a native release exists to download; the sweep must see it.
      downloadUrl: "https://example.test/download",
      fetchImpl: async () =>
        new Response(JSON.stringify({ status: "error" }), { status: 404, headers: { "content-type": "application/json" } })
    })
    await controller.adoptSession({ state: "signed-out", login: null, admin: false })
    // Download is now an explicit embedded prompt, not permanent shell chrome.
    await controller.commands.runForAgent("app.download.prompt")
    await new Promise((resolve) => setTimeout(resolve, 0))
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    flushSync(() => root.render(createElement(ControllerTestProvider, { controller, children: createElement(App) })))
    try {
      const webNames = new Set(controller.commands.all().map((command) => command.name))
      const nativeOnlyNames = new Set((await declared()).filter((entry) => nativeOnly(entry.metadata)).map(nameOf))
      const manifest = host.querySelector(".app-shell")?.getAttribute("data-flows")?.split(" ") ?? []
      expect(manifest.length).toBeGreaterThan(20)
      expect(manifest.filter((name) => !webNames.has(name))).toEqual([])
      expect(manifest.filter((name) => nativeOnlyNames.has(name))).toEqual([])
      const rendered = [...new Set([...host.querySelectorAll("[data-flow]")].map((el) => el.getAttribute("data-flow") ?? ""))]
      // The funnel's two controls are on the page, so the sweep covers them.
      expect(rendered).toContain("auth.sign-in")
      expect(rendered).toContain("app.download")
      expect(rendered.filter((name) => !webNames.has(name))).toEqual([])
      expect(rendered.filter((name) => nativeOnlyNames.has(name))).toEqual([])
    } finally {
      flushSync(() => root.unmount())
      await controller.dispose()
      host.remove()
    }
  })
})

/*
 * Fixture hygiene. This file installs one shared Happy DOM document and builds
 * real controllers on it, and each controller attaches a capture-phase keydown
 * handler to that document. A fixture that is never disposed therefore keeps
 * handling keys — and keeps its store subscriptions and polls alive — for the
 * rest of the process. The parity describe above has released every fixture by
 * the time this runs, so the net registration count is back to zero.
 */
describe("fixture hygiene", () => {
  test("no capture-phase keydown listener outlives the parity fixtures", () => {
    expect(openCaptureKeydown()).toBe(0)
  })
})
