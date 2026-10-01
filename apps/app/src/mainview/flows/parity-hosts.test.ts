/* The web and native catalogs follow the shared bootstrap capabilities. */
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { StorageApi } from "@tanstack/db"
import { afterAll, describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { createElement } from "react"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
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

/** The web bootstrap with every supported shared capability. */
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
    const productCapabilities = [...productSource.matchAll(/result\.Capabilities = append\(result\.Capabilities, ([^)]*)\)/g)]
      .flatMap(match => [...match[1]!.matchAll(/"([^"]+)"/g)].map(value => RuntimeCapabilitySchema.parse(value[1])))
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

  test("the cloud capability table never claims a native door", () => {
    for (const identity of [true, false]) {
      for (const cloud of [true, false]) {
        const emitted = cloudCapabilities({ identity, cloud, agent: true, checkout: true, terminal: true })
        expect(emitted.filter((capability) => capability.startsWith("local.") || capability === "cloud.pat")).toEqual([])
      }
    }
  })

  /*
   * The rendered surface half of (a): the shell mounted under the cloud
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
